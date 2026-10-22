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

const healthDetails = [
  'refused',
  'reset',
  'abort',
  'http-4xx',
  'http-5xx',
  'body-not-ok',
  'wedged',
  'other',
] as const;
const health = { ...metric, readinessReason: 'health' } as const;
const { kind: _kind, ...timed } = health;

test('health details survive both cleaners only on a failed health readiness end event', () => {
  for (const healthDetail of healthDetails) {
    assert.deepEqual(cleanTimingEvent({ ...timed, healthDetail }), { ...timed, healthDetail });
    assert.deepEqual(cleanDiagnostic({ ...health, healthDetail }), { ...health, healthDetail });
  }
  for (const healthDetail of ['PRIVATE-refused', {}, [], 1, null]) {
    assert.equal(cleanTimingEvent({ ...health, healthDetail }), undefined);
    assert.equal(cleanDiagnostic({ ...health, healthDetail }), undefined);
  }
  for (const changes of [
    { readinessReason: 'dead' },
    { readinessReason: undefined },
    { stage: 'capture', readinessReason: undefined },
    { edge: 'start', readinessReason: undefined },
  ]) {
    const event = { ...health, healthDetail: 'refused', ...changes };
    assert.equal(cleanTimingEvent(event), undefined);
    assert.equal(cleanDiagnostic(event), undefined);
  }
});

const postMortem = {
  kind: 'metric',
  stage: 'runner-post-mortem',
  edge: 'point',
  outcome: 'failed',
  at: 210,
  line: 3,
  observation: 7,
  count: 1,
  hostChild: 'exited',
  exitCode: 0,
  exitSignal: 'SIGKILL',
  appProcess: 'changed',
  markerReady: 1,
  markerWaiting: 2,
  markerWaitResult: 0,
  markerListenerFailed: 0,
  markerSendFailed: 1,
} as const;

test('a runner post-mortem keeps only fixed words and counts on its own stage', () => {
  const { kind: _, ...event } = postMortem;
  assert.deepEqual(cleanTimingEvent(postMortem), event);
  assert.deepEqual(cleanDiagnostic({ ...postMortem, raw: 'PRIVATE-tail' }), postMortem);
  for (const hostChild of ['alive', 'exited', 'unknown'])
    assert.equal(cleanDiagnostic({ ...postMortem, hostChild })?.hostChild, hostChild);
  for (const appProcess of ['same', 'changed', 'absent', 'unknown'])
    assert.equal(cleanDiagnostic({ ...postMortem, appProcess })?.appProcess, appProcess);
  for (const exitSignal of ['SIGTERM', 'SIGTRAP', 'other'])
    assert.equal(cleanDiagnostic({ ...postMortem, exitSignal })?.exitSignal, exitSignal);
  for (const [key, value] of [
    ['hostChild', 'PRIVATE-alive'],
    ['appProcess', 4242],
    ['exitSignal', 'PRIVATE-SIG'],
    ['exitCode', -1],
    ['markerWaiting', 'PRIVATE-1'],
  ] as const) {
    assert.equal(cleanTimingEvent({ ...postMortem, [key]: value }), undefined);
    assert.equal(cleanDiagnostic({ ...postMortem, [key]: value }), undefined);
  }
  for (const key of ['hostChild', 'exitCode', 'appProcess', 'markerWaiting'] as const) {
    const misplaced = { ...metric, [key]: postMortem[key] };
    assert.equal(cleanTimingEvent(misplaced), undefined);
    assert.equal(cleanDiagnostic(misplaced), undefined);
  }
});

test('dispatch phase spans survive both cleaners as ordinary timing stages', () => {
  for (const stage of [
    'dispatch-bind',
    'dispatch-native',
    'dispatch-settle',
    'dispatch-health',
    'dispatch-readback',
  ]) {
    const event = { kind: 'metric', stage, edge: 'end', outcome: 'ok', at: 300, ms: 17_600 };
    assert.deepEqual(cleanDiagnostic(event), event);
  }
});
