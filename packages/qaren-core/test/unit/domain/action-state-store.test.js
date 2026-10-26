// Task 4: action-state-store — backend-selecting dual-write facade.
//
// Phase 1 is ADDITIVE dual-write: sidecars stay authoritative (read source),
// the DB is a populated MIRROR. These tests pin:
//   - storeMode() is READ-ONLY (never creates/migrates the DB)
//   - forced-null ctor → 'degraded:sqlite-unavailable' + sidecar still writes
//   - persist() dual-writes BOTH sidecar AND a DB row, and APPENDS history
//   - a DB mirror failure never throws and never corrupts the sidecar
//   - resetActionStore() allows reopening after close
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqlite, openActionDb } from '../../../dist/domain/action-db.js';
import {
  loadOrInitState,
  persist,
  storeMode,
  resetActionStore,
  closeActionStoresForTest,
  __setSqliteCtorForTest,
} from '../../../dist/domain/action-state-store.js';
import { freshRuntimeState } from '../../../dist/domain/reusable-action.js';

function freshProject() {
  const root = mkdtempSync(join(tmpdir(), 'rn-statestore-'));
  mkdirSync(join(root, '.qaren', 'actions'), { recursive: true });
  const yaml = join(root, '.qaren', 'actions', 'login.yaml');
  writeFileSync(yaml, 'appId: x\n---\n- launchApp\n');
  return { root, yaml };
}

function dbPathOf(root) {
  return join(root, '.qaren', 'state', 'actions.db');
}

// The DB deduplicates (action_id, ts), so each record needs its own timestamp.
let runRecordSeq = 0;
function makeRunRecord(overrides = {}) {
  return {
    timestamp: new Date(Date.UTC(2026, 0, 1) + ++runRecordSeq * 1000).toISOString(),
    durationMs: 1234,
    status: 'pass',
    trigger: 'agent',
    ...overrides,
  };
}

// ─── storeMode is read-only: never creates the DB as a side effect ──────────
test('storeMode does NOT create the actions.db (read-only detector)', () => {
  closeActionStoresForTest();
  const { root } = freshProject();
  // Force sqlite available (use the real ctor if present; otherwise this
  // assertion still holds — a degraded mode also creates nothing).
  __setSqliteCtorForTest(loadSqlite());
  const mode = storeMode(root);
  // With sqlite available the mode must be 'sqlite'; degraded otherwise.
  if (loadSqlite()) {
    assert.equal(mode, 'sqlite');
  }
  assert.equal(
    existsSync(dbPathOf(root)),
    false,
    'storeMode must not open/migrate the DB — actions.db should not exist after the call',
  );
  closeActionStoresForTest();
});

// ─── forced-null ctor: degraded mode, sidecar still authoritative ───────────
test('forced-null ctor → degraded:sqlite-unavailable; persist still writes the sidecar', () => {
  closeActionStoresForTest();
  const { root, yaml } = freshProject();
  __setSqliteCtorForTest(null);

  assert.equal(storeMode(root), 'degraded:sqlite-unavailable');

  const s0 = loadOrInitState(yaml, root);
  assert.equal(s0.runHistory.length, 0);

  const next = { ...s0, revision: 2 };
  assert.doesNotThrow(() => persist({ yamlFilePath: yaml, projectRoot: root, state: next }));

  // Sidecar is the authoritative round-trip source in Phase 1.
  assert.equal(
    existsSync(join(root, '.qaren', 'state', 'login.state.json')),
    true,
    'sidecar must be written even in degraded mode',
  );
  assert.equal(loadOrInitState(yaml, root).revision, 2);
  // Never created a DB in degraded mode.
  assert.equal(existsSync(dbPathOf(root)), false);
  closeActionStoresForTest();
});

// ─── dual-write: persist mirrors to the DB and APPENDS run records ──────────
test('persist dual-writes the sidecar AND a DB row; appends (not replaces) history', () => {
  closeActionStoresForTest();
  if (!loadSqlite()) return; // skip-guard: requires real node:sqlite
  const { root, yaml } = freshProject();
  __setSqliteCtorForTest(loadSqlite());

  const s0 = freshRuntimeState(() => new Date(), 0);
  const rec1 = makeRunRecord({ durationMs: 100 });
  persist({
    yamlFilePath: yaml,
    projectRoot: root,
    state: { ...s0, revision: 1 },
    newRunRecord: rec1,
    meta: { appId: 'x', path: yaml, status: 'active' },
  });

  // Sidecar written.
  assert.equal(existsSync(join(root, '.qaren', 'state', 'login.state.json')), true);
  // DB mirror written.
  assert.equal(existsSync(dbPathOf(root)), true);

  // Inspect via an independent handle (the facade caches its own).
  const probe = openActionDb(root);
  assert.ok(probe, 'expected a probe handle');
  const state1 = probe.loadState('login');
  assert.ok(state1, 'expected an actions_index row after first persist');
  assert.equal(state1.runHistory.length, 1, 'first persist appends exactly one run row');
  assert.equal(state1.revision, 1);
  probe.close();

  // Second persist with a DIFFERENT record → appends a 2nd row, not duplicate/replace.
  const rec2 = makeRunRecord({ durationMs: 200 });
  persist({
    yamlFilePath: yaml,
    projectRoot: root,
    state: { ...s0, revision: 2 },
    newRunRecord: rec2,
  });

  const probe2 = openActionDb(root);
  const state2 = probe2.loadState('login');
  assert.equal(state2.runHistory.length, 2, 'second persist appends a second run row');
  const durations = state2.runHistory.map((r) => r.durationMs).sort((a, b) => a - b);
  assert.deepEqual(durations, [100, 200], 'both distinct records present (append, not replace)');
  assert.equal(state2.revision, 2, 'COALESCE upsert reflects the new revision');
  probe2.close();
  closeActionStoresForTest();
});

// ─── dual-write: repair records also mirror ──────────────────────────────────
test('persist mirrors a new repair record to the DB', () => {
  closeActionStoresForTest();
  if (!loadSqlite()) return;
  const { root, yaml } = freshProject();
  __setSqliteCtorForTest(loadSqlite());

  const s0 = freshRuntimeState(() => new Date(), 0);
  const repair = {
    timestamp: new Date().toISOString(),
    failureCode: 'SELECTOR_NOT_FOUND',
    diff: { selector: { from: 'a', to: 'b' } },
    durationMs: 50,
  };
  persist({
    yamlFilePath: yaml,
    projectRoot: root,
    state: { ...s0, revision: 1 },
    newRepairRecord: repair,
  });

  const probe = openActionDb(root);
  const cnt = probe.recentRepairCount('login', new Date(0).toISOString());
  assert.equal(cnt, 1, 'expected exactly one repair record mirrored');
  probe.close();
  closeActionStoresForTest();
});

// ─── best-effort: a DB mirror failure never throws / never corrupts sidecar ──
test('a DB mirror failure does not throw and the sidecar still round-trips', () => {
  closeActionStoresForTest();
  const { root, yaml } = freshProject();

  // A ctor whose db methods throw on any write → upsertIndex/insert throw,
  // but the facade swallows it (best-effort mirror).
  class ThrowingDb {
    exec() {
      /* schema exec ok */
    }
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

  const s0 = loadOrInitState(yaml, root);
  assert.doesNotThrow(() =>
    persist({
      yamlFilePath: yaml,
      projectRoot: root,
      state: { ...s0, revision: 7 },
      newRunRecord: makeRunRecord(),
    }),
  );

  // Sidecar write is unaffected by the mirror failure.
  assert.equal(loadOrInitState(yaml, root).revision, 7);
  closeActionStoresForTest();
});

// ─── resetActionStore allows reopening after close ──────────────────────────
test('resetActionStore evicts the cached handle so the DB can be reopened', () => {
  closeActionStoresForTest();
  if (!loadSqlite()) return;
  const { root, yaml } = freshProject();
  __setSqliteCtorForTest(loadSqlite());

  const s0 = freshRuntimeState(() => new Date(), 0);
  persist({
    yamlFilePath: yaml,
    projectRoot: root,
    state: { ...s0, revision: 1 },
    newRunRecord: makeRunRecord(),
  });
  assert.equal(existsSync(dbPathOf(root)), true);

  // Reset closes + evicts; a subsequent persist must still work (reopen).
  assert.doesNotThrow(() => resetActionStore(root));
  assert.doesNotThrow(() =>
    persist({
      yamlFilePath: yaml,
      projectRoot: root,
      state: { ...s0, revision: 2 },
      newRunRecord: makeRunRecord({ durationMs: 999 }),
    }),
  );

  const probe = openActionDb(root);
  const state = probe.loadState('login');
  assert.equal(state.runHistory.length, 2, 'reopened handle appended a second row');
  probe.close();
  closeActionStoresForTest();
});
