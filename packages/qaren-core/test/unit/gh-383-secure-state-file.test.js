// GH #383: shared hardened state-file IO — extracted from the CDP-015 session
// file so runner state gets the same guarantees: symlink-refusing reads,
// atomic 0600 writes, best-effort deletes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readJsonStateFile,
  writeJsonStateFileAtomic,
  deleteStateFile,
  runnerStatePath,
  getStateDir,
  cleanupLegacyTmpState,
} from '../../dist/util/secure-state-file.js';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'gh383-state-'));
}

test('gh-383 state: write is atomic, 0600, and round-trips', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'nested', 'state.json');
    writeJsonStateFileAtomic(p, { a: 1 });
    assert.deepEqual(readJsonStateFile(p), { a: 1 });
    const mode = statSync(p).mode & 0o777;
    assert.equal(mode, 0o600, 'state file must be user-only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gh-383 state: read refuses to follow a symlink', () => {
  const dir = scratch();
  try {
    const target = join(dir, 'target.json');
    writeFileSync(target, JSON.stringify({ evil: true }));
    const link = join(dir, 'link.json');
    symlinkSync(target, link);
    assert.equal(readJsonStateFile(link), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gh-383 state: read returns null on missing or corrupt file', () => {
  const dir = scratch();
  try {
    assert.equal(readJsonStateFile(join(dir, 'absent.json')), null);
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{not json');
    assert.equal(readJsonStateFile(corrupt), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gh-383 state: delete is idempotent', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'x.json');
    writeJsonStateFileAtomic(p, {});
    deleteStateFile(p);
    deleteStateFile(p);
    assert.equal(readJsonStateFile(p), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gh-383 state: cleanupLegacyTmpState deletes the pre-relocation /tmp files', () => {
  // Spec migration branch: legacy /tmp state is ignored and best-effort deleted.
  // These are the real fixed legacy paths — nothing reads them after #383, so
  // creating + deleting them in a test is safe.
  writeFileSync('/tmp/rn-fast-runner-state.json', '{}');
  writeFileSync('/tmp/rn-android-runner-state.json', '{}');
  cleanupLegacyTmpState();
  assert.equal(readJsonStateFile('/tmp/rn-fast-runner-state.json'), null);
  assert.equal(readJsonStateFile('/tmp/rn-android-runner-state.json'), null);
  cleanupLegacyTmpState();
});

test('gh-383 state: runnerStatePath keys under <stateDir>/runner-state and sanitizes', () => {
  const p = runnerStatePath('ios-ABCD-1234');
  assert.ok(p.startsWith(join(getStateDir(), 'runner-state')));
  assert.ok(p.endsWith('ios-ABCD-1234.json'));
  const weird = runnerStatePath('android-192.168.1.5:5555');
  assert.ok(weird.endsWith('android-192.168.1.5:5555.json'));
  // '.' is allowlisted (serials/versions contain it), so '..' survives as text —
  // the traversal-neutralizing invariant is that no '/' survives, keeping the
  // basename inside runner-state/ ('ios-../../x' → 'ios-.._.._x').
  const hostile = runnerStatePath('ios-../../etc/passwd');
  const base = hostile.slice(join(getStateDir(), 'runner-state').length + 1);
  assert.ok(!base.includes('/'), 'no path separator may survive sanitization');
  assert.ok(hostile.startsWith(join(getStateDir(), 'runner-state')));
});
