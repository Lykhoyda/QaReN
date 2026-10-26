// Task 1: action-db — ESM loader + open + schema + PRAGMA + graceful degradation
// Task 2: action-db — append-and-trim writes, upsertIndex (COALESCE), loadState, recentRepairCount
// Task 3: action-db — migrateSidecars() one-time import of legacy JSON sidecars
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openActionDb, loadSqlite } from '../../../dist/domain/action-db.js';
import {
  freshRuntimeState,
  appendRunRecord,
  appendRepairRecord,
  HISTORY_LIMITS,
} from '../../../dist/domain/reusable-action.js';

// ─── CI-loud assertion: loadSqlite() MUST be non-null on Node 24 ─────────────
test('loadSqlite() returns a non-null ctor on Node 24 (ESM loader smoke test)', () => {
  const ctor = loadSqlite();
  assert.ok(
    ctor !== null,
    'loadSqlite() returned null — the ESM createRequire loader is broken or node:sqlite is unavailable on this Node version',
  );
});

// ─── Happy path: opens DB, creates schema, runs PRAGMAs ─────────────────────
test('openActionDb creates the db file + schema when node:sqlite is available', () => {
  const ctor = loadSqlite();
  if (!ctor) {
    // This branch should NOT be reached on Node 24 (caught by the CI-loud test above).
    // Kept here so an isolated run of this test on an older Node is a clear skip.
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-'));
  const handle = openActionDb(root);
  assert.ok(handle, 'expected a handle when sqlite is available');
  assert.ok(existsSync(join(root, '.qaren', 'state', 'actions.db')));

  const rows = handle.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const names = rows.map((r) => r.name);
  assert.deepEqual(names, ['actions_index', 'repair_records', 'run_records']);

  // Verify key columns exist on actions_index
  const indexCols = handle.db.prepare('PRAGMA table_info(actions_index)').all();
  const indexColNames = indexCols.map((c) => c.name);
  assert.ok(indexColNames.includes('stats_json'), 'actions_index must have stats_json column');
  assert.ok(indexColNames.includes('id'), 'actions_index must have id column');
  assert.ok(indexColNames.includes('app_id'), 'actions_index must have app_id column');

  // Verify run_records has expected columns (including failure_detail)
  const runCols = handle.db.prepare('PRAGMA table_info(run_records)').all();
  const runColNames = runCols.map((c) => c.name);
  assert.ok(runColNames.includes('failure_detail'), 'run_records must have failure_detail column');
  assert.ok(runColNames.includes('id'), 'run_records must have id column');
  assert.ok(runColNames.includes('ts'), 'run_records must have ts column');
  assert.ok(runColNames.includes('status'), 'run_records must have status column');

  // Verify repair_records has AUTOINCREMENT id
  const repairCols = handle.db.prepare('PRAGMA table_info(repair_records)').all();
  const repairColNames = repairCols.map((c) => c.name);
  assert.ok(repairColNames.includes('id'), 'repair_records must have id column');
  assert.ok(repairColNames.includes('action_id'), 'repair_records must have action_id column');

  handle.close();
});

// ─── Graceful degradation: null sqliteCtor → returns null without throwing ──
test('openActionDb returns null and never throws when sqlite ctor is forced null', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-'));
  const handle = openActionDb(root, { sqliteCtor: null });
  assert.equal(handle, null);
});

// ─── Idempotency: calling openActionDb twice on same root is safe ─────────────
test('openActionDb is idempotent (IF NOT EXISTS schema, second open succeeds)', () => {
  const ctor = loadSqlite();
  if (!ctor) return;

  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-idem-'));
  const h1 = openActionDb(root);
  assert.ok(h1);
  h1.close();

  const h2 = openActionDb(root);
  assert.ok(h2, 'second open on same path should succeed');
  h2.close();
});

// ─── Task 2: upsertIndex + insertRunRecord + loadState round-trip ────────────

test('upsertIndex + insertRunRecord + loadState round-trips run history and stats', () => {
  if (!loadSqlite()) return;
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-t2a-'));
  const handle = openActionDb(root);
  assert.ok(handle, 'expected handle');

  let state = freshRuntimeState(() => new Date('2026-06-19T00:00:00Z'), 111);
  state = appendRunRecord(state, {
    timestamp: '2026-06-19T00:01:00Z',
    durationMs: 4200,
    status: 'pass',
    trigger: 'agent',
  });

  // Persist index row with stats; then insert the single run record.
  handle.upsertIndex('login', {
    appId: 'com.x.app',
    path: '/p/login.yaml',
    contentHash: 'abc',
    status: 'active',
    revision: state.revision,
    statsJson: JSON.stringify(state.stats),
    mtimeBaseline: state.lastSeenMtimeMs,
    updatedAt: state.updatedAt,
  });
  handle.insertRunRecord('login', state.runHistory[0]);

  const loaded = handle.loadState('login');
  assert.ok(loaded, 'loadState must return non-null for a known action');
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.runHistory.length, 1);
  assert.equal(loaded.runHistory[0].status, 'pass');
  assert.equal(loaded.runHistory[0].durationMs, 4200);
  assert.equal(loaded.runHistory[0].trigger, 'agent');
  assert.equal(loaded.stats.totalRuns, 1);
  assert.equal(loaded.stats.successCount, 1);
  assert.equal(loaded.stats.failureCount, 0);
  assert.equal(loaded.lastSeenMtimeMs, 111);
  assert.equal(handle.loadState('missing'), null, 'missing action must return null');

  handle.close();
});

test('loadState stats come from stats_json, not recomputed from capped history (totalRuns can exceed history.length)', () => {
  if (!loadSqlite()) return;
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-t2b-'));
  const handle = openActionDb(root);
  assert.ok(handle);

  // Simulate 70 total runs but only 50 rows in DB (cap enforced)
  const bigStats = {
    totalRuns: 70,
    successCount: 65,
    failureCount: 5,
    avgDurationMs: 3000,
    lastSuccessAt: '2026-06-19T01:00:00Z',
  };
  handle.upsertIndex('nav-flow', {
    appId: 'com.x.app',
    status: 'active',
    revision: 1,
    statsJson: JSON.stringify(bigStats),
    mtimeBaseline: 0,
    updatedAt: '2026-06-19T01:00:00Z',
  });

  // Insert exactly RUN_HISTORY_MAX rows (50 — the cap, not 70)
  for (let i = 0; i < HISTORY_LIMITS.RUN_HISTORY_MAX; i++) {
    handle.insertRunRecord('nav-flow', {
      timestamp: `2026-06-19T00:${String(i).padStart(2, '0')}:00Z`,
      durationMs: 1000,
      status: 'pass',
      trigger: 'agent',
    });
  }

  const loaded = handle.loadState('nav-flow');
  assert.ok(loaded);
  assert.equal(loaded.runHistory.length, HISTORY_LIMITS.RUN_HISTORY_MAX, 'history rows preserved');
  assert.equal(
    loaded.stats.totalRuns,
    70,
    'totalRuns must come from stats_json, not history.length',
  );
  assert.equal(loaded.stats.successCount, 65, 'successCount must come from stats_json');

  handle.close();
});

test('insertRunRecord trims oldest rows when exceeding RUN_HISTORY_MAX', () => {
  if (!loadSqlite()) return;
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-t2c-'));
  const handle = openActionDb(root);
  assert.ok(handle);

  handle.upsertIndex('trim-test', {
    status: 'active',
    revision: 1,
    statsJson: '{}',
    mtimeBaseline: 0,
  });

  // Insert RUN_HISTORY_MAX + 5 rows — first 5 should be dropped
  const total = HISTORY_LIMITS.RUN_HISTORY_MAX + 5;
  for (let i = 0; i < total; i++) {
    handle.insertRunRecord('trim-test', {
      timestamp: `2026-06-${String(19 + Math.floor(i / 60)).padStart(2, '0')}T00:${String(i % 60).padStart(2, '0')}:00Z`,
      durationMs: i * 10,
      status: i % 3 === 0 ? 'fail' : 'pass',
      trigger: 'agent',
    });
  }

  const rows = handle.db
    .prepare('SELECT COUNT(*) as cnt FROM run_records WHERE action_id = ?')
    .get('trim-test');
  assert.equal(
    rows.cnt,
    HISTORY_LIMITS.RUN_HISTORY_MAX,
    `run_records must be capped at ${HISTORY_LIMITS.RUN_HISTORY_MAX}`,
  );

  // Oldest row (durationMs=0) should be gone; newest (durationMs=(total-1)*10) present
  const oldest = handle.db
    .prepare('SELECT duration_ms FROM run_records WHERE action_id = ? ORDER BY id ASC LIMIT 1')
    .get('trim-test');
  assert.equal(
    oldest.duration_ms,
    5 * 10,
    'oldest rows trimmed — first surviving row has durationMs=50',
  );

  handle.close();
});

test('insertRepairRecord trims oldest rows when exceeding REPAIR_HISTORY_MAX', () => {
  if (!loadSqlite()) return;
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-t2d-'));
  const handle = openActionDb(root);
  assert.ok(handle);

  handle.upsertIndex('repair-trim', {
    status: 'active',
    revision: 1,
    statsJson: '{}',
    mtimeBaseline: 0,
  });

  const total = HISTORY_LIMITS.REPAIR_HISTORY_MAX + 3;
  for (let i = 0; i < total; i++) {
    handle.insertRepairRecord('repair-trim', {
      timestamp: `2026-06-19T00:${String(i).padStart(2, '0')}:00Z`,
      failureCode: 'SELECTOR_NOT_FOUND',
      diff: { selector: { from: `old-${i}`, to: `new-${i}` } },
      durationMs: i * 5,
      agentReasoning: `reason-${i}`,
    });
  }

  const rows = handle.db
    .prepare('SELECT COUNT(*) as cnt FROM repair_records WHERE action_id = ?')
    .get('repair-trim');
  assert.equal(
    rows.cnt,
    HISTORY_LIMITS.REPAIR_HISTORY_MAX,
    `repair_records capped at ${HISTORY_LIMITS.REPAIR_HISTORY_MAX}`,
  );

  handle.close();
});

test('upsertIndex COALESCE: partial update preserves prior app_id/path/status', () => {
  if (!loadSqlite()) return;
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-t2e-'));
  const handle = openActionDb(root);
  assert.ok(handle);

  // First upsert — full metadata
  handle.upsertIndex('coalesce-test', {
    appId: 'com.example.app',
    path: '/flows/coalesce-test.yaml',
    contentHash: 'hash123',
    status: 'active',
    revision: 2,
    statsJson: JSON.stringify({
      totalRuns: 5,
      successCount: 5,
      failureCount: 0,
      avgDurationMs: 1000,
    }),
    mtimeBaseline: 99,
    updatedAt: '2026-06-19T10:00:00Z',
  });

  // Second upsert — stats-only update (omit appId/path/contentHash/status)
  handle.upsertIndex('coalesce-test', {
    statsJson: JSON.stringify({
      totalRuns: 6,
      successCount: 6,
      failureCount: 0,
      avgDurationMs: 1100,
    }),
  });

  const row = handle.db.prepare('SELECT * FROM actions_index WHERE id = ?').get('coalesce-test');
  assert.equal(row.app_id, 'com.example.app', 'app_id preserved after partial update');
  assert.equal(row.path, '/flows/coalesce-test.yaml', 'path preserved after partial update');
  assert.equal(row.content_hash, 'hash123', 'content_hash preserved after partial update');
  assert.equal(row.status, 'active', 'status preserved after partial update');

  const stats = JSON.parse(row.stats_json);
  assert.equal(stats.totalRuns, 6, 'stats_json updated to new value');

  handle.close();
});

test('loadState reconstructs repair history with diff and agentReasoning', () => {
  if (!loadSqlite()) return;
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-t2f-'));
  const handle = openActionDb(root);
  assert.ok(handle);

  let state = freshRuntimeState(() => new Date('2026-06-19T00:00:00Z'), 0);
  state = appendRepairRecord(state, {
    timestamp: '2026-06-19T00:05:00Z',
    failureCode: 'SELECTOR_NOT_FOUND',
    diff: { selector: { from: 'btn-old', to: 'btn-new', score: 0.85 } },
    durationMs: 800,
    agentReasoning: 'testID was renamed in refactor',
  });

  handle.upsertIndex('repair-roundtrip', {
    status: 'experimental',
    revision: state.revision,
    statsJson: JSON.stringify(state.stats),
    mtimeBaseline: 0,
    updatedAt: state.updatedAt,
  });
  handle.insertRepairRecord('repair-roundtrip', state.repairHistory[0]);

  const loaded = handle.loadState('repair-roundtrip');
  assert.ok(loaded);
  assert.equal(loaded.repairHistory.length, 1);
  const rep = loaded.repairHistory[0];
  assert.equal(rep.failureCode, 'SELECTOR_NOT_FOUND');
  assert.equal(rep.durationMs, 800);
  assert.equal(rep.agentReasoning, 'testID was renamed in refactor');
  assert.deepEqual(rep.diff, { selector: { from: 'btn-old', to: 'btn-new', score: 0.85 } });

  handle.close();
});

test('recentRepairCount returns count within window and 0 outside', () => {
  if (!loadSqlite()) return;
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-t2g-'));
  const handle = openActionDb(root);
  assert.ok(handle);

  handle.upsertIndex('repair-count', {
    status: 'active',
    revision: 1,
    statsJson: '{}',
    mtimeBaseline: 0,
  });

  // Two recent repairs
  handle.insertRepairRecord('repair-count', {
    timestamp: '2026-06-19T10:00:00Z',
    failureCode: 'SELECTOR_NOT_FOUND',
    diff: {},
    durationMs: 100,
  });
  handle.insertRepairRecord('repair-count', {
    timestamp: '2026-06-19T11:00:00Z',
    failureCode: 'SELECTOR_NOT_FOUND',
    diff: {},
    durationMs: 200,
  });
  // One old repair (before the cutoff)
  handle.insertRepairRecord('repair-count', {
    timestamp: '2026-06-18T00:00:00Z',
    failureCode: 'SELECTOR_NOT_FOUND',
    diff: {},
    durationMs: 300,
  });

  // Count since 2026-06-19T09:00:00Z — only 2 qualify
  assert.equal(handle.recentRepairCount('repair-count', '2026-06-19T09:00:00Z'), 2);
  // Count since far future — 0
  assert.equal(handle.recentRepairCount('repair-count', '2026-06-20T00:00:00Z'), 0);
  // Count since epoch — all 3
  assert.equal(handle.recentRepairCount('repair-count', '2000-01-01T00:00:00Z'), 3);

  handle.close();
});

// T2: a failing RunRecord with BOTH failureCode AND failureDetail round-trips.
test('loadState round-trips a fail RunRecord with failureCode + failureDetail', () => {
  if (!loadSqlite()) return;
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-t2i-'));
  const handle = openActionDb(root);
  assert.ok(handle);

  handle.upsertIndex('fail-detail', {
    status: 'active',
    revision: 1,
    statsJson: '{}',
    mtimeBaseline: 0,
  });

  handle.insertRunRecord('fail-detail', {
    timestamp: '2026-06-19T00:03:00Z',
    durationMs: 900,
    status: 'fail',
    trigger: 'agent',
    failureCode: 'SELECTOR_NOT_FOUND',
    failureDetail: 'tapOn id "sign-in" not found on the live snapshot',
  });

  const loaded = handle.loadState('fail-detail');
  assert.ok(loaded);
  assert.equal(loaded.runHistory.length, 1);
  const rec = loaded.runHistory[0];
  assert.equal(rec.status, 'fail');
  assert.equal(rec.failureCode, 'SELECTOR_NOT_FOUND', 'failureCode must round-trip');
  assert.equal(
    rec.failureDetail,
    'tapOn id "sign-in" not found on the live snapshot',
    'failureDetail must round-trip',
  );

  handle.close();
});

test('loadState transport field: only set to cdp-js when column value is cdp-js', () => {
  if (!loadSqlite()) return;
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-t2h-'));
  const handle = openActionDb(root);
  assert.ok(handle);

  handle.upsertIndex('transport-test', {
    status: 'active',
    revision: 1,
    statsJson: '{}',
    mtimeBaseline: 0,
  });

  // One run with transport=cdp-js, one without
  handle.insertRunRecord('transport-test', {
    timestamp: '2026-06-19T00:01:00Z',
    durationMs: 100,
    status: 'pass',
    trigger: 'agent',
    transport: 'cdp-js',
  });
  handle.insertRunRecord('transport-test', {
    timestamp: '2026-06-19T00:02:00Z',
    durationMs: 200,
    status: 'pass',
    trigger: 'ci',
  });

  const loaded = handle.loadState('transport-test');
  assert.ok(loaded);
  assert.equal(loaded.runHistory[0].transport, 'cdp-js', 'transport=cdp-js preserved');
  assert.equal(loaded.runHistory[1].transport, undefined, 'absent transport stays undefined');

  handle.close();
});

// ─── Task 3: migrateSidecars ──────────────────────────────────────────────────

test('migrateSidecars imports legacy .state.json files exactly once', () => {
  if (!loadSqlite()) return;
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-t3a-'));
  const stateDir = join(root, '.qaren', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'login.state.json'),
    JSON.stringify({
      schemaVersion: 1,
      revision: 2,
      updatedAt: '2026-06-19T00:00:00Z',
      lastSeenMtimeMs: 9,
      runHistory: [
        { timestamp: '2026-06-19T00:00:01Z', durationMs: 10, status: 'pass', trigger: 'agent' },
      ],
      repairHistory: [],
      stats: { totalRuns: 1, successCount: 1, failureCount: 0, avgDurationMs: 10 },
    }),
  );

  const handle = openActionDb(root);
  assert.ok(handle, 'expected handle');

  // First call: should migrate 1 sidecar
  assert.equal(handle.migrateSidecars().migrated, 1, 'first call migrates 1 sidecar');

  // Second call: idempotent — index row already exists
  assert.equal(handle.migrateSidecars().migrated, 0, 'second call migrates 0 (idempotent)');

  // loadState should return the imported run history and stats
  const loaded = handle.loadState('login');
  assert.ok(loaded, 'loadState must return non-null for migrated action');
  assert.equal(loaded.runHistory.length, 1, 'runHistory must have 1 imported record');
  assert.equal(loaded.runHistory[0].status, 'pass', 'run record status preserved');
  assert.equal(loaded.runHistory[0].durationMs, 10, 'run record durationMs preserved');
  assert.equal(loaded.stats.totalRuns, 1, 'stats.totalRuns preserved from sidecar');
  assert.equal(loaded.revision, 2, 'revision preserved from sidecar');
  assert.equal(loaded.lastSeenMtimeMs, 9, 'lastSeenMtimeMs preserved from sidecar');

  handle.close();
});

test('migrateSidecars returns migrated=0 when state dir does not exist', () => {
  if (!loadSqlite()) return;
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-t3b-'));
  // Do NOT create .qaren/state/ — test that the function handles a missing dir gracefully
  const handle = openActionDb(root);
  assert.ok(handle);
  assert.equal(handle.migrateSidecars().migrated, 0, 'no state dir → migrated=0');
  handle.close();
});

test('migrateSidecars skips files with wrong schemaVersion or corrupt JSON', () => {
  if (!loadSqlite()) return;
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-t3c-'));
  const stateDir = join(root, '.qaren', 'state');
  mkdirSync(stateDir, { recursive: true });

  // Wrong schemaVersion (2) — should skip
  writeFileSync(
    join(stateDir, 'wrong-version.state.json'),
    JSON.stringify({ schemaVersion: 2, revision: 1, runHistory: [], repairHistory: [], stats: {} }),
  );

  // Corrupt JSON — should skip (not throw)
  writeFileSync(join(stateDir, 'corrupt.state.json'), '{invalid json{{');

  // File without .state.json suffix — should be ignored
  writeFileSync(join(stateDir, 'ignored.json'), JSON.stringify({ schemaVersion: 1 }));

  const handle = openActionDb(root);
  assert.ok(handle);
  assert.equal(handle.migrateSidecars().migrated, 0, 'corrupt/wrong-version sidecars skipped');
  assert.equal(handle.loadState('wrong-version'), null, 'wrong-version action not inserted');
  assert.equal(handle.loadState('corrupt'), null, 'corrupt action not inserted');

  handle.close();
});

test('migrateSidecars imports both runHistory and repairHistory records', () => {
  if (!loadSqlite()) return;
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-t3d-'));
  const stateDir = join(root, '.qaren', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'checkout.state.json'),
    JSON.stringify({
      schemaVersion: 1,
      revision: 5,
      updatedAt: '2026-06-19T12:00:00Z',
      lastSeenMtimeMs: 42,
      runHistory: [
        { timestamp: '2026-06-19T10:00:00Z', durationMs: 200, status: 'pass', trigger: 'agent' },
        {
          timestamp: '2026-06-19T11:00:00Z',
          durationMs: 300,
          status: 'fail',
          trigger: 'ci',
          failureCode: 'TIMEOUT',
        },
      ],
      repairHistory: [
        {
          timestamp: '2026-06-19T10:30:00Z',
          failureCode: 'SELECTOR_NOT_FOUND',
          diff: { selector: { from: 'btn-old', to: 'btn-new', score: 0.9 } },
          durationMs: 500,
          agentReasoning: 'testID renamed',
        },
      ],
      stats: { totalRuns: 2, successCount: 1, failureCount: 1, avgDurationMs: 250 },
    }),
  );

  const handle = openActionDb(root);
  assert.ok(handle);
  assert.equal(handle.migrateSidecars().migrated, 1);

  const loaded = handle.loadState('checkout');
  assert.ok(loaded);
  assert.equal(loaded.runHistory.length, 2, 'both run records imported');
  assert.equal(loaded.runHistory[0].status, 'pass', 'first run record preserved');
  assert.equal(loaded.runHistory[1].status, 'fail', 'second run record preserved');
  assert.equal(loaded.runHistory[1].failureCode, 'TIMEOUT', 'failureCode preserved');
  assert.equal(loaded.repairHistory.length, 1, 'repair record imported');
  assert.equal(
    loaded.repairHistory[0].failureCode,
    'SELECTOR_NOT_FOUND',
    'repair failureCode preserved',
  );
  assert.equal(
    loaded.repairHistory[0].agentReasoning,
    'testID renamed',
    'agentReasoning preserved',
  );
  assert.deepEqual(
    loaded.repairHistory[0].diff,
    { selector: { from: 'btn-old', to: 'btn-new', score: 0.9 } },
    'diff preserved',
  );
  assert.equal(loaded.stats.totalRuns, 2, 'stats preserved from sidecar');

  handle.close();
});
