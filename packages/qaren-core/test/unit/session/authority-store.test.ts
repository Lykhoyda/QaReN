import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  AuthorityStoreUnavailableError,
  openAuthorityStore,
  probeAuthorityStore,
} from '../../../dist/util/sqlite-store.js';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test('authority store reports an explicit unavailable diagnostic without fallback', () => {
  const diagnostic = probeAuthorityStore({ sqliteCtor: null });

  assert.deepEqual(diagnostic, {
    available: false,
    code: 'AUTHORITY_STORE_UNAVAILABLE',
    reason: 'node:sqlite could not be loaded by this Node runtime',
  });
});

test('authority store refuses to open when SQLite is unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-authority-store-'));
  roots.push(root);

  assert.throws(
    () => openAuthorityStore(join(root, 'registry.sqlite3'), { sqliteCtor: null }),
    (error) =>
      error instanceof AuthorityStoreUnavailableError &&
      error.code === 'AUTHORITY_STORE_UNAVAILABLE',
  );
});

test('authority store closes the database when initialization fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-authority-store-'));
  roots.push(root);
  let closed = false;
  class FailingDatabase {
    close() {
      closed = true;
    }
    exec() {
      throw new Error('initialization failed');
    }
    prepare() {
      throw new Error('not reached');
    }
  }

  assert.throws(
    () =>
      openAuthorityStore(join(root, 'registry.sqlite3'), {
        sqliteCtor: FailingDatabase,
      }),
    (error) =>
      error instanceof AuthorityStoreUnavailableError &&
      (error.cause as Error).message === 'initialization failed',
  );
  assert.equal(closed, true);
});

test('authority store closes the database when pre-close hardening fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-authority-store-'));
  roots.push(root);
  const path = join(root, 'registry.sqlite3');
  let closed = false;
  class TrackingDatabase {
    constructor(databasePath: string) {
      writeFileSync(databasePath, '');
    }
    close() {
      closed = true;
    }
    exec() {}
    prepare() {
      return { all: () => [], get: () => undefined, run: () => undefined };
    }
  }
  const store = openAuthorityStore(path, { sqliteCtor: TrackingDatabase });
  rmSync(path);
  mkdirSync(path);

  assert.throws(() => store.close(), /authority database path is not a regular file/);
  assert.equal(closed, true);
});

test('authority store opens a transactional registry with private permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-authority-store-'));
  roots.push(root);
  const path = join(root, 'registry.sqlite3');
  const store = openAuthorityStore(path);

  try {
    assert.deepEqual(probeAuthorityStore(), { available: true });
    assert.equal(
      store.database.prepare('SELECT value FROM authority_meta WHERE key = ?').get('schema_version')
        .value,
      '1',
    );
    assert.ok(store.database.prepare('PRAGMA busy_timeout').get().timeout >= 50);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    store.close();
  }
});

test('authority store retries ordinary SQLite operations during brief writer contention', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-authority-store-retry-'));
  roots.push(root);
  const path = join(root, 'registry.sqlite3');
  let attempts = 0;
  class BusyDatabase {
    constructor(databasePath: string) {
      writeFileSync(databasePath, '');
    }
    close() {}
    exec() {}
    prepare() {
      return {
        all: () => [],
        get: () => undefined,
        run: () => {
          attempts += 1;
          if (attempts < 3) {
            const error = new Error('database is busy');
            (error as Error & { code: string }).code = 'SQLITE_BUSY';
            throw error;
          }
        },
      };
    }
  }
  const store = openAuthorityStore(path, { sqliteCtor: BusyDatabase });
  try {
    store.database.prepare('UPDATE sessions SET updated_ms = 1').run();
    assert.equal(attempts, 3);
  } finally {
    store.close();
  }
});
