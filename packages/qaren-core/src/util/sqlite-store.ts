import { chmodSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const INITIALIZATION_WAIT = new Int32Array(new SharedArrayBuffer(4));
const INITIALIZATION_TIMEOUT_MS = 1_000;
const DATABASE_OPERATION_TIMEOUT_MS = 1_000;

interface PreparedStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface AuthorityDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
}

export type AuthorityDatabaseCtor = new (path: string) => AuthorityDatabase;

export interface AuthorityStore {
  database: AuthorityDatabase;
  secureFiles(): void;
  close(): void;
}

export interface AuthorityStoreUnavailableDiagnostic {
  available: false;
  code: 'AUTHORITY_STORE_UNAVAILABLE';
  reason: string;
}

export type AuthorityStoreDiagnostic = { available: true } | AuthorityStoreUnavailableDiagnostic;

export class AuthorityStoreUnavailableError extends Error {
  readonly code = 'AUTHORITY_STORE_UNAVAILABLE';

  constructor(reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.name = 'AuthorityStoreUnavailableError';
  }
}

function loadAuthoritySqlite(): AuthorityDatabaseCtor | null {
  try {
    const sqlite = require('node:sqlite') as { DatabaseSync?: AuthorityDatabaseCtor };
    return sqlite.DatabaseSync ?? null;
  } catch {
    return null;
  }
}

function assertPrivateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700, recursive: true });
  const link = lstatSync(path);
  if (link.isSymbolicLink() || !link.isDirectory()) {
    throw new Error('authority state root must be a real directory');
  }
  const stat = statSync(path);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('authority state root is not owned by the current user');
  }
  chmodSync(path, 0o700);
}

function secureDatabaseFiles(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const link = lstatSync(candidate);
      if (link.isSymbolicLink() || !link.isFile()) {
        throw new Error('authority database path is not a regular file');
      }
      const stat = statSync(candidate);
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error('authority database is not owned by the current user');
      }
      chmodSync(candidate, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
  }
}

function runInitialization(operation: () => void): void {
  runWithBusyRetry(operation, INITIALIZATION_TIMEOUT_MS);
}

function runWithBusyRetry<T>(operation: () => T, timeoutMs = DATABASE_OPERATION_TIMEOUT_MS): T {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return operation();
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : '';
      if (code !== 'SQLITE_BUSY' && !/database is (?:locked|busy)/i.test(message)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      Atomics.wait(INITIALIZATION_WAIT, 0, 0, Math.min(25, remaining));
    }
  }
}

function retryingDatabase(database: AuthorityDatabase): AuthorityDatabase {
  return {
    close: () => database.close(),
    exec: (sql) => runWithBusyRetry(() => database.exec(sql)),
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        get: (...params) => runWithBusyRetry(() => statement.get(...params)),
        run: (...params) => runWithBusyRetry(() => statement.run(...params)),
        all: (...params) => runWithBusyRetry(() => statement.all(...params)),
      };
    },
  };
}

export function probeAuthorityStore(
  options: { sqliteCtor?: AuthorityDatabaseCtor | null } = {},
): AuthorityStoreDiagnostic {
  const ctor = options.sqliteCtor === undefined ? loadAuthoritySqlite() : options.sqliteCtor;
  return ctor
    ? { available: true }
    : {
        available: false,
        code: 'AUTHORITY_STORE_UNAVAILABLE',
        reason: 'node:sqlite could not be loaded by this Node runtime',
      };
}

export function openAuthorityStore(
  path: string,
  options: { sqliteCtor?: AuthorityDatabaseCtor | null } = {},
): AuthorityStore {
  const ctor = options.sqliteCtor === undefined ? loadAuthoritySqlite() : options.sqliteCtor;
  if (!ctor) {
    throw new AuthorityStoreUnavailableError(
      'node:sqlite could not be loaded by this Node runtime',
    );
  }

  let database: AuthorityDatabase | null = null;
  try {
    assertPrivateDirectory(dirname(path));
    try {
      const existing = lstatSync(path);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error('authority database path is not a regular file');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const rawDatabase = new ctor(path);
    const openedDatabase = retryingDatabase(rawDatabase);
    database = openedDatabase;
    secureDatabaseFiles(path);
    runInitialization(() =>
      openedDatabase.exec(`
        PRAGMA busy_timeout=50;
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS authority_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO authority_meta(key, value)
        VALUES ('schema_version', '1')
        ON CONFLICT(key) DO NOTHING;
      `),
    );
    secureDatabaseFiles(path);
    return {
      database: openedDatabase,
      secureFiles: () => secureDatabaseFiles(path),
      close: () => {
        let failure: unknown;
        try {
          secureDatabaseFiles(path);
        } catch (error) {
          failure = error;
        }
        try {
          openedDatabase.close();
        } catch (error) {
          failure ??= error;
        }
        try {
          secureDatabaseFiles(path);
        } catch (error) {
          failure ??= error;
        }
        if (failure) throw failure;
      },
    };
  } catch (cause) {
    try {
      database?.close();
    } catch {}
    throw new AuthorityStoreUnavailableError('authority registry could not be opened', { cause });
  }
}
