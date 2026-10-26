// GH #397 — DB mirror round-trip for the new RunRecord fields. The routing
// audit trail (deviceId, blindProbe) must survive the SQLite mirror, and
// records without them must reconstruct clean (no null-pollution).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openActionDb } from '../../dist/domain/action-db.js';
import type { RunRecord } from '../../src/domain/reusable-action.js';

function withDb(fn: (db: NonNullable<ReturnType<typeof openActionDb>>, root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'rn-agent-db-test-'));
  const db = openActionDb(root);
  try {
    assert.ok(db, 'node:sqlite available in this runtime');
    fn(db, root);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('gh-397: deviceId + blindProbe round-trip through the mirror', () => {
  withDb((db) => {
    const record: RunRecord = {
      timestamp: '2026-07-05T00:00:00Z',
      durationMs: 1234,
      status: 'pass',
      trigger: 'agent',
      transport: 'cdp-js',
      deviceId: 'UDID-1',
      blindProbe: { atRisk: 'ios26', skippedMaestro: true },
    };
    db.upsertIndex('demo', { appId: 'com.test.app', status: 'experimental', path: '/x/demo.yaml' });
    db.insertRunRecord('demo', record);
    const state = db.loadState('demo');
    assert.ok(state);
    const rec = state.runHistory.at(-1);
    assert.ok(rec);
    assert.equal(rec.deviceId, 'UDID-1');
    assert.deepEqual(rec.blindProbe, { atRisk: 'ios26', skippedMaestro: true });
  });
});

test('gh-397: records without the new fields reconstruct clean', () => {
  withDb((db) => {
    db.upsertIndex('demo', { appId: 'com.test.app', status: 'experimental', path: '/x/demo.yaml' });
    db.insertRunRecord('demo', {
      timestamp: '2026-07-05T00:00:01Z',
      durationMs: 10,
      status: 'pass',
      trigger: 'agent',
    });
    const rec = db.loadState('demo')?.runHistory.at(-1);
    assert.ok(rec);
    assert.equal('deviceId' in rec, false, 'no null-pollution');
    assert.equal('blindProbe' in rec, false, 'no null-pollution');
  });
});

test('gh-623: trailing verification qualifier round-trips through the mirror', () => {
  withDb((db) => {
    const trailingVerification: NonNullable<RunRecord['trailingVerification']> = {
      trailingVerificationOnly: true,
      mutationEvidence: 'proven',
      provenMutations: 5,
      failedVerifications: 1,
      notRunOperations: 0,
      attempt: {
        attemptId: 'attempt-repaired',
        ordinal: 2,
        kind: 'repaired',
        parentAttemptId: 'attempt-initial',
      },
      stageTerminations: [
        {
          exitCode: 1,
          signal: null,
          timedOut: false,
          outputTruncated: false,
          bootstrapFailure: false,
          transportFailure: false,
          artifactFinalized: true,
        },
      ],
    };
    db.upsertIndex('demo', { appId: 'com.test.app', status: 'experimental', path: '/x/demo.yaml' });
    db.insertRunRecord('demo', {
      timestamp: '2026-08-29T00:00:00Z',
      durationMs: 30_000,
      status: 'fail',
      trigger: 'agent',
      trailingVerification,
    });

    const rec = db.loadState('demo')?.runHistory.at(-1);
    assert.ok(rec);
    assert.deepEqual(rec.trailingVerification, trailingVerification);
  });
});
