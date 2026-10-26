// GH #520: both Android hittable sources must route through the shared
// HittableSemantics predicate (iOS #395 parity: enabled AND visibly
// on-screen). The dispatcher lives in the androidTest sourceset where JVM
// unit tests cannot reach it, so — same style as gh-397-pin-sync /
// gh-418-command-surface-sync — this grep-sync pins the WIRING while
// HittableSemanticsTest.kt (JVM lane) pins the semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const DISPATCHER = join(
  REPO_ROOT,
  'packages',
  'rn-android-runner',
  'app',
  'src',
  'androidTest',
  'java',
  'dev',
  'lykhoyda',
  'rndevagent',
  'androidrunner',
  'CommandDispatcher.kt',
);
const src = readFileSync(DISPATCHER, 'utf8');

test('gh-520: snapshot path routes hittable through HittableSemantics.fromSnapshotNode', () => {
  assert.match(src, /put\("hittable",\s*HittableSemantics\.fromSnapshotNode\(/);
});

test('gh-520: find path routes hittable through HittableSemantics.fromFoundObject', () => {
  assert.match(src, /put\("hittable",\s*HittableSemantics\.fromFoundObject\(/);
});

test('gh-520: no raw single-signal hittable puts remain', () => {
  assert.doesNotMatch(src, /put\("hittable",\s*visible\)/);
  assert.doesNotMatch(src, /put\("hittable",\s*obj\.isEnabled\)/);
});

test('gh-520: Android /health advertises HONEST_HITTABLE like iOS', () => {
  const server = readFileSync(join(dirname(DISPATCHER), 'CommandServer.kt'), 'utf8');
  assert.match(server, /"HONEST_HITTABLE"/);
});
