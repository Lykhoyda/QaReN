// Task 5: action-store.ts is store-aware — every authoritative write also
// mirrors to the node:sqlite DB (Phase 1 dual-write, A2/A3/A5).
//
// These tests pin:
//   - mirrorToDb derives the right projectRoot/actionId from a
//     .qaren/actions/<id>.yaml path and writes to
//     <projectRoot>/.qaren/state/actions.db
//   - after a saveAction + a persistRun-style RunRecord append, the DB has the
//     index row (cumulative stats from stats_json) AND the appended
//     run_records row
//   - a forced mirror failure never breaks the authoritative sidecar write
//     and never throws into the authoritative path
//   - the #101 pair-write + #117 CAS semantics are not regressed by the mirror
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqlite, openActionDb } from '../../../dist/domain/action-db.js';
import {
  mirrorToDb,
  closeActionStoresForTest,
  __setSqliteCtorForTest,
} from '../../../dist/domain/action-state-store.js';
import { loadAction, saveAction, saveActionWithCAS } from '../../../dist/domain/action-store.js';
import { freshRuntimeState, appendRunRecord } from '../../../dist/domain/reusable-action.js';

function freshProject(id = 'login') {
  const root = mkdtempSync(join(tmpdir(), 'rn-store-mirror-'));
  mkdirSync(join(root, '.qaren', 'actions'), { recursive: true });
  const yaml = join(root, '.qaren', 'actions', `${id}.yaml`);
  writeFileSync(
    yaml,
    [
      'appId: com.x',
      '---',
      '# id: ' + id,
      '# intent: do the thing',
      '# status: active',
      '# appId: com.x',
      '- launchApp',
      '- tapOn:',
      '    id: "old-selector"',
      '',
    ].join('\n'),
  );
  return { root, yaml, id };
}

function dbPathOf(root) {
  return join(root, '.qaren', 'state', 'actions.db');
}

function makeRunRecord(overrides = {}) {
  return {
    timestamp: new Date().toISOString(),
    durationMs: 1234,
    status: 'pass',
    trigger: 'agent',
    ...overrides,
  };
}

// ─── mirrorToDb derives projectRoot/actionId from the YAML path ──────────────
test('mirrorToDb derives projectRoot + actionId from a .qaren/actions/<id>.yaml path', () => {
  closeActionStoresForTest();
  if (!loadSqlite()) return; // skip-guard: requires real node:sqlite
  const { root, yaml } = freshProject('derive-me');
  __setSqliteCtorForTest(loadSqlite());

  let probe;
  try {
    const s0 = freshRuntimeState(() => new Date(), 0);
    // No projectRoot passed — it must be derived from the YAML path.
    mirrorToDb({
      yamlFilePath: yaml,
      state: { ...s0, revision: 3 },
      meta: { appId: 'com.x', status: 'active' },
    });

    // The DB landed at <projectRoot>/.qaren/state/actions.db.
    assert.equal(
      existsSync(dbPathOf(root)),
      true,
      'mirror must write to <root>/.qaren/state/actions.db',
    );

    probe = openActionDb(root);
    const state = probe.loadState('derive-me');
    assert.ok(state, 'expected an actions_index row keyed by the derived actionId');
    assert.equal(state.revision, 3);
  } finally {
    probe?.close();
    closeActionStoresForTest();
  }
});

// ─── mirrorToDb skips a synthetic/non-conventional path (fails open) ─────────
test('mirrorToDb is a no-op (never throws) for a non-.qaren path', () => {
  closeActionStoresForTest();
  try {
    __setSqliteCtorForTest(loadSqlite());
    const root = mkdtempSync(join(tmpdir(), 'rn-store-synth-'));
    const synthetic = join(root, 'inline-action.yaml');
    const s0 = freshRuntimeState(() => new Date(), 0);
    assert.doesNotThrow(() =>
      mirrorToDb({ yamlFilePath: synthetic, state: { ...s0, revision: 1 } }),
    );
    // No DB should be created — the path doesn't resolve to a project root.
    assert.equal(existsSync(join(root, '.qaren')), false);
  } finally {
    closeActionStoresForTest();
  }
});

// ─── saveAction + a RunRecord append: index row + run row in the DB ──────────
test('saveAction + persistRun-style append: DB has the index row (cumulative stats) AND the run row', () => {
  closeActionStoresForTest();
  if (!loadSqlite()) return;
  const { root } = freshProject('run-mirror');
  __setSqliteCtorForTest(loadSqlite());

  let probe;
  try {
    // 1. saveAction mirrors the index row (no run row yet).
    const action = loadAction(root, 'run-mirror');
    assert.ok(action, 'expected to load the freshly-written action');
    saveAction(action);

    probe = openActionDb(root);
    let state = probe.loadState('run-mirror');
    assert.ok(state, 'saveAction must seed the index row');
    assert.equal(state.runHistory.length, 0, 'saveAction appends NO run row');
    probe.close();
    probe = null;

    // 2. persistRun-style: append a RunRecord then CAS-save, then mirror the row.
    const fresh = loadAction(root, 'run-mirror');
    const record = makeRunRecord({ durationMs: 500, status: 'pass' });
    const next = { ...fresh, state: appendRunRecord(fresh.state, record) };
    const result = saveActionWithCAS(next);
    assert.equal(result.ok, true, 'CAS save must succeed (no concurrent writer)');
    mirrorToDb({
      yamlFilePath: next.filePath,
      state: next.state,
      newRunRecord: record,
      meta: { appId: next.metadata.appId, status: next.metadata.status, path: next.filePath },
    });

    probe = openActionDb(root);
    state = probe.loadState('run-mirror');
    assert.equal(state.runHistory.length, 1, 'exactly one run row appended');
    assert.equal(state.runHistory[0].durationMs, 500);
    // Cumulative stats come from the stored stats_json (not recomputed from rows).
    assert.equal(state.stats.totalRuns, 1, 'cumulative totalRuns reflects the append');
    assert.equal(state.stats.successCount, 1);
  } finally {
    probe?.close();
    closeActionStoresForTest();
  }
});

// ─── forced mirror failure: authoritative sidecar write survives + no throw ──
test('a forced mirror failure does not break the authoritative sidecar write or throw', () => {
  closeActionStoresForTest();
  try {
    const { root } = freshProject('throwing');

    // A ctor whose write methods throw → the mirror swallows it (best-effort).
    class ThrowingDb {
      exec() {}
      prepare() {
        return {
          run() {
            throw new Error('simulated DB write failure');
          },
          get() {
            return undefined;
          },
          all() {
            return [];
          },
        };
      }
      close() {}
    }
    __setSqliteCtorForTest(ThrowingDb);

    const action = loadAction(root, 'throwing');
    assert.ok(action);
    // saveAction internally calls mirrorToDb; the throwing mirror must not
    // propagate out of the authoritative write.
    assert.doesNotThrow(() => saveAction(action));

    // The authoritative sidecar was written despite the mirror failure.
    const sidecar = join(root, '.qaren', 'state', 'throwing.state.json');
    assert.equal(existsSync(sidecar), true, 'sidecar must be written even when the mirror throws');
    const parsed = JSON.parse(readFileSync(sidecar, 'utf8'));
    assert.equal(parsed.schemaVersion, 1);
  } finally {
    closeActionStoresForTest();
  }
});

// ─── I1: migration-boundary double-count — append is idempotent on (id, ts) ──
// Repro of the exact dual-write ordering bug: saveSidecar runs FIRST so the
// sidecar already contains run1+run2 before mirrorToDb runs. The first
// mirror call opens the DB, which lazily migrates the sidecar (importing
// run1+run2), THEN appends run2 again. The idempotent (action_id, ts) guard
// must make that append a no-op so the DB faithfully holds 2 rows, not 3.
function seedSidecar(root, id, sidecar) {
  const stateDir = join(root, '.qaren', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `${id}.state.json`), JSON.stringify(sidecar));
}

test('I1: migrated sidecar + record-bearing mirror does NOT double-count the newest run/repair', () => {
  closeActionStoresForTest();
  if (!loadSqlite()) return;
  const { root, yaml, id } = freshProject('migrate-dedupe');
  __setSqliteCtorForTest(loadSqlite());

  const run1 = {
    timestamp: '2026-06-19T00:01:00Z',
    durationMs: 100,
    status: 'pass',
    trigger: 'agent',
  };
  const run2 = {
    timestamp: '2026-06-19T00:02:00Z',
    durationMs: 200,
    status: 'pass',
    trigger: 'agent',
  };
  const repair1 = {
    timestamp: '2026-06-19T00:01:30Z',
    failureCode: 'SELECTOR_NOT_FOUND',
    diff: { selector: { from: 'a', to: 'b', score: 0.9 } },
    durationMs: 50,
  };
  const repair2 = {
    timestamp: '2026-06-19T00:02:30Z',
    failureCode: 'SELECTOR_NOT_FOUND',
    diff: { selector: { from: 'c', to: 'd', score: 0.8 } },
    durationMs: 60,
  };

  let probe;
  try {
    // The authoritative sidecar already holds BOTH run records and BOTH repair
    // records (saveSidecar-first ordering) before the mirror runs.
    seedSidecar(root, id, {
      schemaVersion: 1,
      revision: 2,
      updatedAt: '2026-06-19T00:02:00Z',
      lastSeenMtimeMs: 1,
      runHistory: [run1, run2],
      repairHistory: [repair1, repair2],
      stats: { totalRuns: 2, successCount: 2, failureCount: 0, avgDurationMs: 150 },
    });

    // First record-bearing mirror: dbFor() lazily migrates run1+run2 / repair1+repair2,
    // then this call appends run2 + repair2 again — the idempotent guard must drop them.
    mirrorToDb({
      yamlFilePath: yaml,
      state: {
        schemaVersion: 1,
        revision: 2,
        updatedAt: '2026-06-19T00:02:00Z',
        lastSeenMtimeMs: 1,
        runHistory: [run1, run2],
        repairHistory: [repair1, repair2],
        stats: { totalRuns: 2, successCount: 2, failureCount: 0, avgDurationMs: 150 },
      },
      newRunRecord: run2,
      newRepairRecord: repair2,
      meta: { appId: 'com.x', status: 'active' },
    });

    probe = openActionDb(root);
    let runRows = probe.db
      .prepare('SELECT ts FROM run_records WHERE action_id = ? ORDER BY id ASC')
      .all(id);
    let repairRows = probe.db
      .prepare('SELECT ts FROM repair_records WHERE action_id = ? ORDER BY id ASC')
      .all(id);
    probe.close();
    probe = null;

    assert.equal(runRows.length, 2, 'run_records must equal the authoritative count (2), NOT 3');
    assert.deepEqual(
      runRows.map((r) => r.ts),
      [run1.timestamp, run2.timestamp],
      'no duplicate run ts at the migration boundary',
    );
    assert.equal(
      repairRows.length,
      2,
      'repair_records must equal the authoritative count (2), NOT 3',
    );
    assert.deepEqual(
      repairRows.map((r) => r.ts),
      [repair1.timestamp, repair2.timestamp],
      'no duplicate repair ts at the migration boundary',
    );

    // A SECOND distinct persist (a genuinely new run3) appends normally → 3 rows, each once.
    const run3 = {
      timestamp: '2026-06-19T00:03:00Z',
      durationMs: 300,
      status: 'pass',
      trigger: 'agent',
    };
    mirrorToDb({
      yamlFilePath: yaml,
      state: {
        schemaVersion: 1,
        revision: 3,
        updatedAt: '2026-06-19T00:03:00Z',
        lastSeenMtimeMs: 1,
        runHistory: [run1, run2, run3],
        repairHistory: [repair1, repair2],
        stats: { totalRuns: 3, successCount: 3, failureCount: 0, avgDurationMs: 200 },
      },
      newRunRecord: run3,
      meta: { appId: 'com.x', status: 'active' },
    });

    probe = openActionDb(root);
    runRows = probe.db
      .prepare('SELECT ts FROM run_records WHERE action_id = ? ORDER BY id ASC')
      .all(id);
    probe.close();
    probe = null;
    assert.equal(runRows.length, 3, 'a distinct new run appends (3 rows)');
    assert.deepEqual(
      runRows.map((r) => r.ts),
      [run1.timestamp, run2.timestamp, run3.timestamp],
      'each run ts present exactly once after the distinct append',
    );
  } finally {
    probe?.close();
    closeActionStoresForTest();
  }
});

// ─── I1 control: a FRESH action (no legacy sidecar) appends normally ─────────
test('I1 control: fresh action with no legacy sidecar appends each run/repair once', () => {
  closeActionStoresForTest();
  if (!loadSqlite()) return;
  const { root, yaml, id } = freshProject('fresh-append');
  __setSqliteCtorForTest(loadSqlite());
  // No seedSidecar — there is nothing for migrateSidecars to import.

  let probe;
  try {
    const s0 = freshRuntimeState(() => new Date(), 0);
    const runA = makeRunRecord({ timestamp: '2026-06-19T01:00:00Z', durationMs: 11 });
    const runB = makeRunRecord({ timestamp: '2026-06-19T01:01:00Z', durationMs: 22 });

    mirrorToDb({
      yamlFilePath: yaml,
      state: { ...s0, revision: 1, runHistory: [runA] },
      newRunRecord: runA,
      meta: { appId: 'com.x', status: 'active' },
    });
    mirrorToDb({
      yamlFilePath: yaml,
      state: { ...s0, revision: 2, runHistory: [runA, runB] },
      newRunRecord: runB,
      meta: { appId: 'com.x', status: 'active' },
    });

    probe = openActionDb(root);
    const runRows = probe.db
      .prepare('SELECT ts FROM run_records WHERE action_id = ? ORDER BY id ASC')
      .all(id);
    probe.close();
    probe = null;
    assert.deepEqual(
      runRows.map((r) => r.ts),
      [runA.timestamp, runB.timestamp],
      'fresh action: each distinct run appended exactly once',
    );
  } finally {
    probe?.close();
    closeActionStoresForTest();
  }
});

// ─── #117 CAS conflict is preserved: the mirror never masks a conflict ───────
test('#117: a CAS conflict is still returned (mirror does not convert it to a success)', () => {
  closeActionStoresForTest();
  try {
    __setSqliteCtorForTest(loadSqlite());
    const { root } = freshProject('cas');

    // Load twice — two in-memory snapshots at the same mtime baseline.
    const a = loadAction(root, 'cas');
    const b = loadAction(root, 'cas');
    assert.ok(a && b);

    // First writer wins (advances the on-disk lastSeenMtimeMs).
    const aNext = { ...a, state: appendRunRecord(a.state, makeRunRecord()) };
    const r1 = saveActionWithCAS(aNext);
    assert.equal(r1.ok, true);

    // Second writer raced — its snapshot is stale; CAS must refuse.
    // (Only meaningful when the on-disk mtime actually advanced; first save may
    // have had a 0 baseline, so re-load b to a real baseline then stale it.)
    const bReloaded = loadAction(root, 'cas');
    // Re-save again so the on-disk mtime is strictly greater than bReloaded's
    // captured baseline.
    const bWriter = { ...bReloaded, state: appendRunRecord(bReloaded.state, makeRunRecord()) };
    const aThird = loadAction(root, 'cas');
    // Assert the conflict-creating write succeeds — if it no-ops the EXTERNAL_WRITE
    // assertion below passes for the wrong reason.
    const rConflict = saveActionWithCAS({
      ...aThird,
      state: appendRunRecord(aThird.state, makeRunRecord()),
    });
    assert.equal(
      rConflict.ok,
      true,
      'conflict-creating write must succeed to create a valid stale baseline',
    );
    const r2 = saveActionWithCAS(bWriter);
    assert.equal(r2.ok, false, 'stale snapshot must hit a CAS conflict');
    assert.equal(r2.conflict, 'EXTERNAL_WRITE');
  } finally {
    closeActionStoresForTest();
  }
});

// ─── F1 regression: malformed sidecar must not leave a partial index row ─────
// migrateSidecars() must skip a sidecar whose runHistory/repairHistory is not
// an array — writing NO actions_index row — so a later well-formed retry can
// still import it. A valid sidecar must still migrate fully.
test('F1: malformed sidecar (non-array histories) leaves no partial index row; valid one migrates fully', () => {
  closeActionStoresForTest();
  if (!loadSqlite()) return;
  const root = mkdtempSync(join(tmpdir(), 'rn-f1-malform-'));
  mkdirSync(join(root, '.qaren', 'actions'), { recursive: true });
  __setSqliteCtorForTest(loadSqlite());

  let probe;
  try {
    const stateDir = join(root, '.qaren', 'state');
    mkdirSync(stateDir, { recursive: true });

    // Malformed: runHistory is a plain object, not an array.
    writeFileSync(
      join(stateDir, 'bad-action.state.json'),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        updatedAt: '2026-06-19T10:00:00Z',
        lastSeenMtimeMs: 0,
        runHistory: { not: 'an array' },
        repairHistory: [],
        stats: { totalRuns: 0, successCount: 0, failureCount: 0, avgDurationMs: 0 },
      }),
    );

    // Valid sidecar that should migrate normally.
    const goodRun = {
      timestamp: '2026-06-19T10:01:00Z',
      durationMs: 99,
      status: 'pass',
      trigger: 'agent',
    };
    writeFileSync(
      join(stateDir, 'good-action.state.json'),
      JSON.stringify({
        schemaVersion: 1,
        revision: 2,
        updatedAt: '2026-06-19T10:01:00Z',
        lastSeenMtimeMs: 1,
        runHistory: [goodRun],
        repairHistory: [],
        stats: { totalRuns: 1, successCount: 1, failureCount: 0, avgDurationMs: 99 },
      }),
    );

    probe = openActionDb(root);
    const { migrated } = probe.migrateSidecars();

    // Only the well-formed sidecar should have migrated.
    assert.equal(migrated, 1, 'only the valid sidecar should migrate');

    // Malformed sidecar must leave NO index row (retryable later if fixed).
    const badRow = probe.db.prepare('SELECT 1 FROM actions_index WHERE id = ?').get('bad-action');
    assert.equal(badRow, undefined, 'malformed sidecar must NOT create an actions_index row');

    // Valid sidecar must be fully migrated: index row + history row.
    const goodState = probe.loadState('good-action');
    assert.ok(goodState, 'valid sidecar must have an actions_index row');
    assert.equal(goodState.revision, 2);
    assert.equal(goodState.runHistory.length, 1);
    assert.equal(goodState.runHistory[0].timestamp, goodRun.timestamp);

    // Idempotency: re-running migrateSidecars must not double-insert rows or change migrated count.
    const { migrated: migrated2 } = probe.migrateSidecars();
    assert.equal(migrated2, 0, 're-running migrate on already-imported action must be a no-op');
    const goodStateAgain = probe.loadState('good-action');
    assert.equal(
      goodStateAgain.runHistory.length,
      1,
      'idempotent retry must not duplicate run rows',
    );
  } finally {
    probe?.close();
    closeActionStoresForTest();
  }
});
