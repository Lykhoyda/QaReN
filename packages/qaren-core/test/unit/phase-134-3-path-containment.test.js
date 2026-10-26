// Phase 134.3 — path containment. Two helpers in domain/path-safety.ts:
//
//   - isValidActionId(s) — strict regex for caller-supplied action IDs
//     that flow into the `.qaren/actions/<id>.yaml` path segment.
//     Rejects path-traversal payloads (`../etc/passwd`, `/abs/path`),
//     control chars, and over-long input.
//   - assertWithinDir(child, baseDir) — defense-in-depth containment
//     check on a resolved path. Throws PathTraversalError when the
//     resolved child escapes baseDir.
//
// Closes:
//   HIGH: action-store.ts actionId escape (deepsec)
//   HIGH: index.ts learned-action IDs unconstrained
//   MEDIUM: scanDir recursive read outside project root
//   MEDIUM: device-list.ts unrestricted screenshot output path
//   MEDIUM: auto-login.ts predictable /tmp YAML clobbering
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const MOD_PATH = '../../dist/domain/path-safety.js';

// ── isValidActionId ─────────────────────────────────────────────────

test('isValidActionId: accepts kebab-case + snake_case + alphanumeric', async () => {
  const { isValidActionId } = await import(MOD_PATH);
  assert.equal(isValidActionId('login-flow'), true);
  assert.equal(isValidActionId('add_cart_item'), true);
  assert.equal(isValidActionId('glass-carousel-v2'), true);
  assert.equal(isValidActionId('test123'), true);
  assert.equal(isValidActionId('abc'), true);
});

test('isValidActionId: rejects path-traversal payloads', async () => {
  const { isValidActionId } = await import(MOD_PATH);
  assert.equal(isValidActionId('../etc/passwd'), false);
  assert.equal(isValidActionId('..'), false);
  assert.equal(isValidActionId('../../system'), false);
  assert.equal(isValidActionId('foo/../bar'), false);
  assert.equal(isValidActionId('foo/bar'), false);
});

test('isValidActionId: rejects absolute paths', async () => {
  const { isValidActionId } = await import(MOD_PATH);
  assert.equal(isValidActionId('/etc/passwd'), false);
  assert.equal(isValidActionId('/tmp/x'), false);
  assert.equal(isValidActionId('C:\\Windows\\System32'), false);
});

test('isValidActionId: rejects newlines and control characters', async () => {
  const { isValidActionId } = await import(MOD_PATH);
  assert.equal(isValidActionId('foo\nbar'), false);
  assert.equal(isValidActionId('foo\rbar'), false);
  assert.equal(isValidActionId('foobar'), false);
});

test('isValidActionId: rejects empty, too-long, non-string', async () => {
  const { isValidActionId } = await import(MOD_PATH);
  assert.equal(isValidActionId(''), false);
  assert.equal(isValidActionId(null), false);
  assert.equal(isValidActionId(undefined), false);
  assert.equal(isValidActionId(42), false);
  assert.equal(isValidActionId('a'.repeat(200)), false);
});

test('isValidActionId: rejects leading-special-char IDs (must start alphanumeric)', async () => {
  const { isValidActionId } = await import(MOD_PATH);
  assert.equal(isValidActionId('-leading-hyphen'), false);
  assert.equal(isValidActionId('_leading-underscore'), false);
  assert.equal(isValidActionId('.hidden'), false);
});

// ── assertWithinDir ─────────────────────────────────────────────────

test('assertWithinDir: accepts paths inside the base directory', async () => {
  const { assertWithinDir } = await import(MOD_PATH);
  const base = join(tmpdir(), 'rn-agent-test');
  // Each call must throw nothing — assertWithinDir returns void on pass.
  assert.doesNotThrow(() => assertWithinDir('foo.yaml', base));
  assert.doesNotThrow(() => assertWithinDir('sub/dir/file.txt', base));
  assert.doesNotThrow(() => assertWithinDir('./foo', base));
  assert.doesNotThrow(() => assertWithinDir(resolve(base, 'absolute-child.txt'), base));
});

test('assertWithinDir: rejects ../ traversal', async () => {
  const { assertWithinDir, PathTraversalError } = await import(MOD_PATH);
  const base = join(tmpdir(), 'rn-agent-test');
  assert.throws(() => assertWithinDir('../etc/passwd', base), PathTraversalError);
  assert.throws(() => assertWithinDir('../../../system32', base), PathTraversalError);
  assert.throws(() => assertWithinDir('sub/../../escape', base), PathTraversalError);
});

test('assertWithinDir: rejects absolute paths outside base', async () => {
  const { assertWithinDir, PathTraversalError } = await import(MOD_PATH);
  const base = join(tmpdir(), 'rn-agent-test');
  assert.throws(() => assertWithinDir('/etc/passwd', base), PathTraversalError);
  assert.throws(() => assertWithinDir('/var/log/system.log', base), PathTraversalError);
});

test('assertWithinDir: rejects sibling dirs that share a prefix (the boundary bug)', async () => {
  const { assertWithinDir, PathTraversalError } = await import(MOD_PATH);
  // /tmp/foo-extra should NOT be considered "within" /tmp/foo — naive
  // startsWith without a trailing separator would have allowed this.
  const base = '/tmp/foo';
  assert.throws(() => assertWithinDir('/tmp/foo-extra/file', base), PathTraversalError);
  assert.throws(() => assertWithinDir('/tmp/foobar', base), PathTraversalError);
});

test('assertWithinDir: accepts base directory itself', async () => {
  const { assertWithinDir } = await import(MOD_PATH);
  const base = join(tmpdir(), 'rn-agent-test');
  assert.doesNotThrow(() => assertWithinDir(base, base));
  assert.doesNotThrow(() => assertWithinDir('.', base));
});

// ── isWithinDir (non-throwing variant) ──────────────────────────────

test('isWithinDir: returns boolean for legitimate + illegitimate inputs', async () => {
  const { isWithinDir } = await import(MOD_PATH);
  const base = join(tmpdir(), 'rn-agent-test');
  assert.equal(isWithinDir('safe-child.yaml', base), true);
  assert.equal(isWithinDir('../escape', base), false);
  assert.equal(isWithinDir('/etc/passwd', base), false);
});
