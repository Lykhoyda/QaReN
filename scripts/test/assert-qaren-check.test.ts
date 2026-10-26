import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCheck } from '../assert-qaren-check.ts';
import { readFileSync } from 'node:fs';

const coreProof = {
  run_id: 'check-fixture',
  pgid: 9000,
  at: '2026-02-02T02:42:00Z',
  outcome: 'absent',
};
const resetProof = {
  run_id: 'check-fixture',
  app_id: 'com.fixture',
  device_id: 'selected-device',
  proven_absent_at: '2026-02-02T02:40:00Z',
  status: 'proven_absent',
};

const receipt = {
  schema: 'qaren/1',
  verb: 'check',
  run_id: 'check-fixture',
  phase: 'cleaned',
  result: 'pass',
  ledger: { verdict: 'PASS' },
  device: { ios_udid: 'selected-device' },
  outcomes: { fresh_install: 'proven_absent' },
  cleanup: { core: 'absent', metro: 'removed', simulator: 'kept', device_lease: 'removed' },
  emitted_at: '2026-02-02T02:43:00Z',
  candidate: { app_id: 'com.fixture' },
  core_cleanup: coreProof,
  fresh_install: resetProof,
};
const record = {
  schema: 'qaren-run/1',
  run_id: 'check-fixture',
  phase: 'cleaned',
  created_at: '2026-02-02T02:39:00Z',
  candidate: { app_id: 'com.fixture' },
  resources: {
    device_borrowed: true,
    ios_simulator: { udid: 'selected-device' },
    core_cleanup: coreProof,
    fresh_install: resetProof,
  },
};
const base = {
  verdict: 'PASS',
  llmTurns: 0,
  escapes: 0,
  recoveries: 0,
  steps: [{ resolvedBy: 'exact' }],
  jev: { calls: 1, callDetails: [{ scope: 'preflight', outcome: 'ok' }] },
};

test('the phrase gate cannot pass merely because the fixed preflight probe ran', () => {
  assert.doesNotThrow(() => assertCheck(receipt, base, false, record));
  assert.throws(() => assertCheck(receipt, base, true, record), /preflight alone is insufficient/);
  const phrase = {
    ...base,
    steps: [{ resolvedBy: 'jev' }],
    jev: { calls: 2, callDetails: [...base.jev.callDetails, { scope: 'walk', outcome: 'ok' }] },
  };
  assert.doesNotThrow(() => assertCheck(receipt, phrase, true, record));
  assert.throws(() => assertCheck(receipt, { ...phrase, llmTurns: 1 }, true, record), /escape/);
  assert.throws(
    () => assertCheck(receipt, { ...phrase, verdict: 'FAIL' }, true, record),
    /both say PASS/,
  );
  assert.throws(() => assertCheck({}, phrase, true, record), /both say PASS/);
});

test('PASS alone is not proof of a clean fresh-install gate', () => {
  for (const invalid of [
    { ...receipt, phase: 'walking' },
    { ...receipt, failure: { code: 'CLEANUP_INCOMPLETE' } },
    { ...receipt, outcomes: {} },
    { ...receipt, cleanup: undefined },
    { ...receipt, cleanup: {} },
    ...['unresolved: retained: metro', 'refused: foreign holder', 'kept', 'unknown'].map(
      (outcome) => ({
        ...receipt,
        cleanup: { ...receipt.cleanup, device_lease: outcome },
      }),
    ),
    { ...receipt, cleanup: { ...receipt.cleanup, core: 'unresolved: still running' } },
    { ...receipt, cleanup: { ...receipt.cleanup, metro: 'kept' } },
  ]) {
    assert.throws(() => assertCheck(invalid, base, false, record), /clean|fresh/);
  }
  for (const invalid of [
    undefined,
    {},
    { ...record, run_id: 'other-run' },
    { ...record, phase: 'walking' },
    { ...record, failure: { code: 'CLEANUP_INCOMPLETE' } },
    { ...record, resources: undefined },
    { ...record, resources: {} },
    ...['lease', 'metro', 'core', 'build_lock'].map((key) => ({
      ...record,
      resources: { ...record.resources, [key]: {} },
    })),
    { ...record, resources: { ...record.resources, ios_simulator: { udid: 'other-device' } } },
  ]) {
    assert.throws(() => assertCheck(receipt, base, false, invalid), /clean/);
  }
  assert.doesNotThrow(() =>
    assertCheck(
      {
        ...receipt,
        cleanup: {
          metro: 'absent',
          core: 'absent',
          simulator: 'kept',
          device_lease: 'absent',
        },
      },
      base,
      false,
      record,
    ),
  );
});

test('the phrase gate plan has no quotes and covers the same onboarding journey', () => {
  const plan = readFileSync(
    new URL('../../packages/qaren-core/test/fixtures/plans/phrases.md', import.meta.url),
    'utf8',
  );
  assert.ok(!/["“”]/.test(plan));
  assert.match(plan, /skip onboarding/);
  assert.match(plan, /tasks tab/);
  assert.equal(plan.split('\n').filter((l) => l.startsWith('✓')).length, 2);
});

test('missing core cleanup cannot be replaced by the absence of a core resource', () => {
  assert.throws(
    () =>
      assertCheck(
        { ...receipt, cleanup: { ...receipt.cleanup, core: undefined } },
        base,
        false,
        record,
      ),
    /core|clean/,
  );
});

test('core cleanup must be complete, positive and durably bound to this run', () => {
  for (const proof of [
    undefined,
    {},
    { ...coreProof, run_id: 'other' },
    { ...coreProof, pgid: undefined },
    { ...coreProof, pgid: 1 },
    { ...coreProof, outcome: 'unresolved' },
    { ...coreProof, outcome: undefined },
    { ...coreProof, at: undefined },
    { ...coreProof, at: 'garbage' },
    { ...coreProof, at: '2026-02-02T02:38:00Z' },
    { ...coreProof, at: '2026-02-02T02:44:00Z' },
  ]) {
    assert.throws(
      () => assertCheck({ ...receipt, core_cleanup: proof }, base, false, record),
      /core/,
    );
    assert.throws(
      () =>
        assertCheck(receipt, base, false, {
          ...record,
          resources: { ...record.resources, core_cleanup: proof },
        }),
      /core/,
    );
    assert.throws(
      () =>
        assertCheck({ ...receipt, core_cleanup: proof }, base, false, {
          ...record,
          resources: { ...record.resources, core_cleanup: proof },
        }),
      /core/,
    );
  }
  assert.throws(
    () =>
      assertCheck(receipt, base, false, {
        ...record,
        resources: { ...record.resources, core_cleanup: { ...coreProof, pgid: 9001 } },
      }),
    /core/,
  );
});

test('fresh reset requires matching complete durable evidence for the selected app and device', () => {
  for (const proof of [
    undefined,
    {},
    { ...resetProof, run_id: 'other' },
    { ...resetProof, app_id: 'com.other' },
    { ...resetProof, app_id: undefined },
    { ...resetProof, device_id: 'other' },
    { ...resetProof, status: 'unknown' },
    { ...resetProof, proven_absent_at: undefined },
    { ...resetProof, proven_absent_at: 'garbage' },
    { ...resetProof, proven_absent_at: '2026-02-02T02:38:00Z' },
    { ...resetProof, proven_absent_at: '2026-02-02T02:43:00Z' },
  ]) {
    assert.throws(
      () => assertCheck({ ...receipt, fresh_install: proof }, base, false, record),
      /fresh/,
    );
    assert.throws(
      () =>
        assertCheck(receipt, base, false, {
          ...record,
          resources: { ...record.resources, fresh_install: proof },
        }),
      /fresh/,
    );
    assert.throws(
      () =>
        assertCheck({ ...receipt, fresh_install: proof }, base, false, {
          ...record,
          resources: { ...record.resources, fresh_install: proof },
        }),
      /fresh/,
    );
  }
  assert.throws(
    () => assertCheck(receipt, base, false, { ...record, candidate: { app_id: 'com.other' } }),
    /fresh/,
  );
  assert.throws(
    () =>
      assertCheck(receipt, base, false, {
        ...record,
        resources: {
          ...record.resources,
          fresh_install: { ...resetProof, proven_absent_at: '2026-02-02T02:41:00Z' },
        },
      }),
    /fresh/,
  );
});
