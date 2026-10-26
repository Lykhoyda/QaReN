// Task 6: cdp_status.actionStore — read-only backend visibility.
//
// Tests:
//   1. storeMode() returns one of the allowed literals for a fresh temp root.
//   2. Calling storeMode() does NOT create the DB file (read-only contract).
//   3. storeMode() returns 'degraded:sqlite-unavailable' when the ctor is forced null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  storeMode,
  closeActionStoresForTest,
  __setSqliteCtorForTest,
} from '../../dist/domain/action-state-store.js';

const ALLOWED_MODES = /** @type {const} */ (['sqlite', 'legacy-files']);

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'rn-status-'));
}

function dbPathOf(root) {
  return join(root, '.qaren', 'state', 'actions.db');
}

test('storeMode: returns an allowed literal for a fresh temp root', () => {
  const root = tempRoot();
  try {
    const mode = storeMode(root);
    assert.ok(
      ALLOWED_MODES.includes(mode) || mode.startsWith('degraded:'),
      `unexpected storeMode value: ${mode}`,
    );
  } finally {
    closeActionStoresForTest();
  }
});

test('storeMode: does NOT create the DB file (read-only contract)', () => {
  const root = tempRoot();
  try {
    storeMode(root);
    assert.equal(existsSync(dbPathOf(root)), false, 'storeMode must not create the DB file');
  } finally {
    closeActionStoresForTest();
  }
});

test('storeMode: returns degraded:sqlite-unavailable when ctor forced null', () => {
  const root = tempRoot();
  try {
    __setSqliteCtorForTest(null);
    const mode = storeMode(root);
    assert.equal(mode, 'degraded:sqlite-unavailable');
  } finally {
    __setSqliteCtorForTest(undefined);
    closeActionStoresForTest();
  }
});
